// =============================================================================
// Mobile M1 — parita modulov, navigácia, odkazy, dialógy (2026-09-28).
//
// SPUSTENIE
//   npm run test:mobile-m1
//
// Beží v režime MOBILNÉHO buildu (NEXT_PUBLIC_ESBLU_MOBILE=1 pred importmi).
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NEXT_PUBLIC_ESBLU_MOBILE = "1";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

const routes = await import("@/lib/app-routes");
const nav = await import("@/lib/mobile-nav");
const links = await import("@/lib/entity-links");
const navigation = await import("@/lib/app-navigation");
const backStack = await import("@/lib/back-stack");
const { resolveEsbluDeepLink } = await import("../mobile/app/deep-link-resolve.ts");

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

// -----------------------------------------------------------------------------
// Cesty v repozitári: JEDEN kanonický tvar = relatívne k ROOT, oddeľovač "/".
// Všetky porovnania v testoch (výnimky, Set-y, startsWith) píšu cesty takto.
// Na Windows by path.join vrátil "app\\components\\X.tsx" a výnimky by potichu
// nezabrali (falošné FAIL, alebo horšie — falošné OK pri zakázaných importoch).
// Preto sa relatívne cesty skladajú výhradne cez path.posix a každá cesta,
// ktorá príde z fs/path, prejde cez repoPath(). path.join(ROOT, rel) potom
// funguje na oboch OS (Windows akceptuje "/").
// -----------------------------------------------------------------------------
const repoPath = (p: string) => path.posix.normalize(p.replace(/\\/g, "/"));

function walk(dir: string, filter: (name: string) => boolean, out: string[] = []): string[] {
  const base = repoPath(dir);
  for (const name of readdirSync(path.join(ROOT, base))) {
    if (["node_modules", ".next", "out", "android", "public"].includes(name)) continue;
    const rel = path.posix.join(base, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, filter, out);
    else if (filter(name)) out.push(rel);
  }
  return out;
}

const UUID = "0f0e0d0c-0b0a-4908-8706-050403020100";

await check("infra: walk() a importGraph() vracajú kanonické cesty s \"/\" (Windows aj POSIX)", () => {
  assert.equal(repoPath("app\\components\\PublicLandingPage.tsx"), "app/components/PublicLandingPage.tsx");
  const files = walk("app", (n) => n.endsWith(".tsx"));
  assert.ok(files.length > 50, "walk nenašiel súbory");
  assert.ok(files.every((f) => !f.includes("\\") && !f.startsWith("./")), "walk vrátil cestu s \\");
  assert.ok(files.includes("app/components/PublicLandingPage.tsx"), "výnimky porovnávajú presne tento tvar");
  assert.ok(files.includes("app/components/voice/VoiceLauncherSlot.tsx"));
});


// -----------------------------------------------------------------------------
// 1. Routy v appke
// -----------------------------------------------------------------------------
await check("nové M1 routy sú v mobilnom bundli (stránky existujú)", () => {
  for (const route of ["/faktury", "/faktury/new", "/faktury/detail", "/obchodni-partneri", "/obchodni-partneri/detail", "/priecinky", "/priecinky/detail", "/chat"]) {
    assert.ok(routes.MOBILE_STATIC_ROUTES.has(route), route);
    const file = route === "/" ? "mobile/app/page.tsx" : `mobile/app${route}/page.tsx`;
    assert.ok(statSync(path.join(ROOT, file)).isFile(), file);
  }
  assert.equal(routes.MOBILE_STATIC_ROUTES.has("/cennik"), false, "cenník v natívnej appke zámerne nie je");
});

await check("detailové wrappery čítajú ?id= a znovupoužívajú zdieľané view", () => {
  assert.match(read("mobile/app/faktury/detail/page.tsx"), /InvoiceDetailView entityId=\{id\}/);
  assert.match(read("mobile/app/obchodni-partneri/detail/page.tsx"), /PartnerDetailView partnerId=\{id\}/);
  assert.match(read("mobile/app/priecinky/detail/page.tsx"), /FolderDetailView folderId=\{id\}/);
  const chat = read("mobile/app/chat/page.tsx");
  assert.match(chat, /ChatShell activeConversationId=\{activeConversationId\}/);
  assert.match(chat, /ChatMessageView conversationId=\{activeConversationId\}/);
  // web wrappery ostávajú tenké
  assert.match(read("app/obchodni-partneri/[id]/page.tsx"), /PartnerDetailView partnerId=\{String\(id\)\}/);
  assert.match(read("app/chat/layout.tsx"), /<ChatShell activeConversationId=\{activeConversationId\}>/);
});

// -----------------------------------------------------------------------------
// 2. Mapovanie odkazov (asistent, vyhľadávanie, karty)
// -----------------------------------------------------------------------------
await check("mobil: webové detaily faktúr/partnerov/priečinkov/chatu → statické ?id= routy", () => {
  assert.equal(routes.resolveAppHref(`/faktury/${UUID}`, true), `/faktury/detail?id=${UUID}`);
  assert.equal(routes.resolveAppHref(`/obchodni-partneri/${UUID}`, true), `/obchodni-partneri/detail?id=${UUID}`);
  assert.equal(routes.resolveAppHref(`/priecinky/${UUID}`, true), `/priecinky/detail?id=${UUID}`);
  assert.equal(routes.resolveAppHref(`/chat/${UUID}`, true), `/chat?id=${UUID}`);
  assert.equal(routes.resolveAppHref("/faktury/new?corrects=abc", true), "/faktury/new?corrects=abc");
  assert.equal(routes.resolveAppHref("/obchodni-partneri?new=1", true), "/obchodni-partneri?new=1");
  assert.equal(routes.resolveAppHref(`/ai-evidencia?openDocument=${UUID}`, true), `/ai-evidencia?openDocument=${UUID}`);
  assert.equal(routes.resolveAppHref("/cennik", true), null);
  assert.equal(routes.resolveAppHref(`/chat/${UUID}/x`, true), null);
  assert.equal(routes.resolveAppHref("/chat/<img>", true), null);
});

await check("entity-links v mobile builde smerujú na zabalené routy", () => {
  for (const href of [
    links.invoiceDetailHref(UUID),
    links.partnerDetailHref(UUID),
    links.folderDetailHref(UUID),
    links.chatConversationHref(UUID),
    links.vehicleDetailHref(UUID),
    links.machineDetailHref(UUID),
    links.inventoryItemDetailHref(UUID),
  ]) {
    const pathname = href.split("?")[0];
    assert.ok(routes.MOBILE_STATIC_ROUTES.has(pathname), href);
    assert.equal(routes.resolveAppHref(href, true), href);
  }
});

await check("každý odkaz, ktorý vytvára server/asistent (lib/intents, lib/document-folders, lib/chat), má v appke cieľ", () => {
  const files = [...walk("lib/intents", (n) => n.endsWith(".ts")), "lib/document-folders.ts", "lib/chat.ts", "lib/invoicing/received-invoice-route.ts"];
  const found: string[] = [];
  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(/href:\s*(`[^`]*`|"[^"]*")/g)) found.push(`${file}::${m[1]}`);
    for (const m of src.matchAll(/return\s+`(\/[^`]*)`;/g)) found.push(`${file}::\`${m[1]}\``);
  }
  assert.ok(found.length > 20, `nájdených odkazov: ${found.length}`);
  const missing: string[] = [];
  for (const entry of found) {
    const [file, literal] = entry.split("::");
    const sample = literal
      .slice(1, -1)
      .replace(/\$\{encodeURIComponent\([^}]*\)\}/g, UUID)
      .replace(/\$\{[^}]*\}/g, UUID);
    if (!sample.startsWith("/")) continue;
    if (routes.resolveAppHref(sample, true) === null) missing.push(`${file}: ${literal}`);
  }
  assert.deepEqual(missing, []);
});

await check("odkazy v Dashboarde (dlaždice, menu) majú v appke cieľ alebo sa skryjú", () => {
  const src = read("app/components/Dashboard.tsx");
  const hrefs = [...src.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 10);
  for (const href of hrefs) assert.notEqual(routes.resolveAppHref(href, true), null, href);
  assert.match(src, /if \(!isAppRouteAvailable\(href\)\) return false;/);
});

await check("statické interné href/Link/BackLink v app/** mieria na zabalené routy (okrem webových/verejných stránok)", () => {
  // Webové-only stránky, ktoré mobilný build nebalí: cenník a jeho klient.
  const webOnly = new Set(["app/cennik/page.tsx", "app/cennik/PricingPageClient.tsx", "app/components/PublicLandingPage.tsx", "app/components/sidebar.tsx"]);
  const offenders: string[] = [];
  for (const file of walk("app", (n) => n.endsWith(".tsx"))) {
    if (file.startsWith("app/api") || webOnly.has(file)) continue;
    const src = read(file);
    for (const m of src.matchAll(/href=\{?["'`](\/[^"'`$]*)["'`]/g)) {
      if (routes.resolveAppHref(m[1], true) === null) offenders.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

await check("web-only odkazy: cenník / landing sa v appke nevykreslia", () => {
  const home = read("app/page.tsx");
  assert.match(home, /IS_MOBILE_BUILD \? <MobileSignedOutRedirect \/> : <PublicLandingPage \/>/);
  assert.match(home, /router\.replace\("\/login"\)/);
  // žiadny iný komponent neodkazuje na /cennik
  const offenders = walk("app", (n) => n.endsWith(".tsx"))
    .filter((f) => !f.startsWith("app/cennik") && f !== "app/components/PublicLandingPage.tsx")
    .filter((f) => /href=\{?["'`]\/cennik/.test(read(f)));
  assert.deepEqual(offenders, []);
});

// -----------------------------------------------------------------------------
// 3. Tvrdá navigácia (plný reload) v appke
// -----------------------------------------------------------------------------
await check("hardNavigationTarget: appka → statický .html súbor, web → bez zmeny", () => {
  const h = navigation.hardNavigationTarget;
  assert.equal(h("/login", true), "/login.html");
  assert.equal(h("/login?ucet-zruseny=1", true), "/login.html?ucet-zruseny=1");
  assert.equal(h("/", true), "/");
  assert.equal(h(`/faktury/${UUID}`, true), `/faktury/detail.html?id=${UUID}`);
  assert.equal(h("/ai-evidencia?openDocument=x&processReceived=1", true), "/ai-evidencia.html?openDocument=x&processReceived=1");
  assert.equal(h("/cennik", true), "/", "neexistujúci cieľ → domov");
  assert.equal(h("https://evil.example", true), "/");
  assert.equal(h("/login", false), "/login");
  assert.equal(h(`/faktury/${UUID}`, false), `/faktury/${UUID}`);
});

await check("v app/** už nie je window.location.href = \"/…\" ani holé <a href> na interné routy bez prekladu", () => {
  const offenders: string[] = [];
  for (const file of walk("app", (n) => n.endsWith(".tsx"))) {
    if (file.startsWith("app/api")) continue;
    const src = read(file);
    if (/window\.location\.href\s*=\s*["'`]\//.test(src)) offenders.push(`${file}: window.location`);
    for (const m of src.matchAll(/<a\s+[^>]*?href=\{(invoiceDetailHref|receivedInvoiceRoute|vehicleDetailHref|partnerDetailHref|folderDetailHref)\(/g)) {
      offenders.push(`${file}: <a href={${m[1]}(…)}>`);
    }
  }
  assert.deepEqual(offenders, []);
});

// -----------------------------------------------------------------------------
// 4. Navigácia podľa rolí
// -----------------------------------------------------------------------------
const keys = (items: { key: string }[]) => items.map((item) => item.key);
const all = (model: ReturnType<typeof nav.mobileNavModel>) => [...keys(model.tabs), ...keys(model.more)];
const FINANCE = ["invoices", "partners", "folders"];
const OPERATIONAL = ["vehicles", "machines", "inventory"];

await check("owner: financie aj prevádzka, asistent v moduloch", () => {
  const m = nav.mobileNavModel({ role: "owner" });
  assert.deepEqual(keys(m.tabs), ["home", "inbox", "invoices", "vehicles"]);
  assert.deepEqual(keys(m.more), ["partners", "folders", "machines", "inventory", "chat", "settings"]);
  assert.equal(m.assistantInModules, true);
});

await check("admin bez financií: žiadne finančné ciele (financie neimplicitné)", () => {
  const m = nav.mobileNavModel({ role: "admin", permissions: {} });
  for (const key of FINANCE) assert.ok(!all(m).includes(key), key);
  assert.deepEqual(keys(m.tabs), ["home", "inbox", "vehicles", "machines"]);
  assert.deepEqual(keys(m.more), ["inventory", "chat", "settings"]);
});

await check("admin s finance.view: faktúry + partneri, priečinky iba s finance.manage", () => {
  const view = nav.mobileNavModel({ role: "admin", permissions: { finance: { view: true } } });
  assert.ok(all(view).includes("invoices") && all(view).includes("partners"));
  assert.ok(!all(view).includes("folders"));
  const manage = nav.mobileNavModel({ role: "admin", permissions: { finance: { manage: true } } });
  assert.ok(all(manage).includes("folders"));
});

await check("accountant: iba financie (žiadne vozidlá/stroje/sklad)", () => {
  const m = nav.mobileNavModel({ role: "accountant" });
  for (const key of OPERATIONAL) assert.ok(!all(m).includes(key), key);
  assert.deepEqual(keys(m.tabs), ["home", "inbox", "invoices", "partners"]);
  assert.deepEqual(keys(m.more), ["folders", "chat", "settings"]);
  assert.equal(m.assistantInModules, true);
});

await check("employee: nikdy financie (ani s podvrhnutými permissions), bez asistenta v moduloch", () => {
  for (const permissions of [{}, { finance: { view: true, manage: true } }]) {
    const m = nav.mobileNavModel({ role: "employee", permissions });
    for (const key of FINANCE) assert.ok(!all(m).includes(key), key);
    assert.deepEqual(keys(m.tabs), ["home", "inbox", "vehicles", "inventory"]);
    assert.deepEqual(keys(m.more), ["machines", "chat", "settings"]);
    assert.equal(m.assistantInModules, false);
  }
});

await check("neprihlásený / bez členstva: žiadna navigácia", () => {
  const empty = { tabs: [], more: [], humanChat: false, aiAssistant: "none", assistantInModules: false };
  assert.deepEqual(nav.mobileNavModel(null), empty);
  assert.deepEqual(nav.mobileNavModel({ role: null }), empty);
});

await check("každý navigačný cieľ každej roly je v appke zabalený; lišta max 5 položiek", () => {
  const inputs = [
    { role: "owner" as const },
    { role: "admin" as const, permissions: {} },
    { role: "admin" as const, permissions: { finance: { manage: true } } },
    { role: "accountant" as const },
    { role: "employee" as const },
  ];
  for (const input of inputs) {
    const m = nav.mobileNavModel(input);
    assert.ok(m.tabs.length + (m.more.length ? 1 : 0) <= 5, input.role);
    for (const item of [...m.tabs, ...m.more]) {
      assert.notEqual(routes.resolveAppHref(item.href, true), null, `${input.role}: ${item.href}`);
    }
    assert.equal(new Set(all(m)).size, all(m).length, "bez duplicít");
  }
});

await check("aktívna položka a skryté cesty (prihlásenie, právne texty)", () => {
  const m = nav.mobileNavModel({ role: "owner" });
  const items = [...m.tabs, ...m.more];
  assert.equal(nav.activeMobileNavKey("/", items), "home");
  assert.equal(nav.activeMobileNavKey("/faktury/detail", items), "invoices");
  assert.equal(nav.activeMobileNavKey("/faktury/detail.html", items), "invoices");
  assert.equal(nav.activeMobileNavKey("/obchodni-partneri/detail", items), "partners");
  assert.equal(nav.activeMobileNavKey("/chat", items), "chat");
  assert.equal(nav.activeMobileNavKey("/neexistuje", items), null);
  for (const p of ["/login", "/login.html", "/reset-hesla", "/invite", "/onboarding/company", "/auth/callback", "/dpa", "/ochrana-osobnych-udajov"]) {
    assert.equal(nav.isChromelessPath(p), true, p);
  }
  for (const p of ["/", "/faktury", "/nastavenia", "/chat"]) assert.equal(nav.isChromelessPath(p), false, p);
});

await check("i18n kľúče navigácie existujú v sk/en/de", async () => {
  const { translate } = await import("@/lib/i18n/translate");
  const labelKeys = new Set([...nav.mobileNavModel({ role: "owner" }).tabs, ...nav.mobileNavModel({ role: "owner" }).more].map((i) => i.labelKey));
  for (const key of [...labelKeys, "nav.more", "nav.moreTitle", "nav.mainNavigation", "nav.assistant", "nav.logout", "nav.logoutConfirm", "vehicles.detail.deadlineOverdue", "vehicles.detail.deadlineDueSoon", "vehicles.detail.deadlinesLabel"]) {
    for (const locale of ["sk", "en", "de"] as const) assert.notEqual(translate(locale, key), key, `${locale}:${key}`);
  }
});

// -----------------------------------------------------------------------------
// 4b. HUMAN CHAT vs. AI ASSISTANT — dve oddelené schopnosti
// -----------------------------------------------------------------------------
const ROLES = ["owner", "admin", "accountant", "employee"] as const;

await check("HUMAN_CHAT_ALLOWED: chat je v navigácii KAŽDEJ roly vrátane zamestnanca", () => {
  for (const role of ROLES) {
    for (const permissions of [{}, { finance: { view: true, manage: true } }]) {
      const m = nav.mobileNavModel({ role, permissions });
      assert.equal(m.humanChat, true, role);
      assert.ok(all(m).includes("chat"), `${role}: chat chýba v navigácii`);
      assert.equal(nav.humanChatAllowed(role), true, role);
    }
  }
  assert.equal(nav.humanChatAllowed(null), false);
});

await check("AI_ASSISTANT_DENIED: zamestnanec nemá všeobecného asistenta (iba Inbox príjem); chat nie je obrazovka asistenta", () => {
  assert.equal(nav.aiAssistantAccess("employee"), "inbox-intake-only");
  assert.equal(nav.mobileNavModel({ role: "employee", permissions: { finance: { manage: true } } }).assistantInModules, false);
  for (const screen of ["chat", "dashboard", "vehicles", "machines", "inventory", "invoices", "folders", "partners", null]) {
    assert.equal(nav.assistantLauncherAllowed("employee", screen), false, `employee @ ${screen}`);
  }
  assert.equal(nav.assistantLauncherAllowed("employee", "inbox"), true, "úzka výnimka: príjem dokladov v Inboxe");
  // chat nikdy nie je obrazovka asistenta — pre žiadnu rolu
  for (const role of ROLES) assert.equal(nav.assistantLauncherAllowed(role, "chat"), false, role);
  // ostatné roly: asistent podľa oprávnení (server je autorita)
  assert.equal(nav.aiAssistantAccess("owner"), "full");
  assert.equal(nav.aiAssistantAccess("admin"), "full");
  assert.equal(nav.aiAssistantAccess("accountant"), "finance-scoped");
  assert.equal(nav.aiAssistantAccess(null), "none");
  assert.equal(nav.assistantLauncherAllowed(null, "inbox"), false);
});

/** Všetky lokálne moduly dosiahnuteľné importmi zo súboru (tranzitívne). */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [repoPath(entry)];
  const exts = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = read(file);
    for (const m of src.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g)) {
      const spec = m[1];
      if (/^import\s+type\b/.test(m[0])) continue;
      let base: string | null = null;
      if (spec.startsWith("@/")) base = repoPath(spec.slice(2));
      else if (spec.startsWith(".")) base = path.posix.join(path.posix.dirname(file), spec);
      if (!base) continue;
      for (const ext of exts) {
        const candidate = base + ext;
        try {
          if (statSync(path.join(ROOT, candidate)).isFile()) { queue.push(candidate); break; }
        } catch { /* ďalšia prípona */ }
      }
    }
  }
  return seen;
}

await check("HUMAN_CHAT_ALLOWED / AI_ASSISTANT_DENIED: chat obrazovky neimportujú žiadnu časť asistenta (ani tranzitívne)", () => {
  const forbidden = [
    /^app\/components\/voice\//,
    /^hooks\/use-voice-session/,
    /^hooks\/use-voice-capture/,
    /^lib\/intents\//,
    /^lib\/voice\//,
    /^app\/components\/Dashboard\.tsx$/,
    /^app\/components\/document\/DocumentLayout\.tsx$/,
  ];
  for (const entry of ["mobile/app/chat/page.tsx", "app/chat/layout.tsx", "app/chat/[conversationId]/page.tsx", "app/chat/ChatShell.tsx"]) {
    const graph = importGraph(entry);
    assert.ok(graph.has("app/components/chat/ChatMessageView.tsx") || graph.has("app/components/chat/ChatConversationList.tsx"), entry);
    const hits = [...graph].filter((file) => forbidden.some((re) => re.test(file)));
    assert.deepEqual(hits, [], `${entry} → ${hits.join(", ")}`);
    for (const file of graph) {
      const src = read(file);
      assert.doesNotMatch(src, /["'`]\/api\/assistant\//, `${file} volá /api/assistant`);
    }
  }
});

await check("AI_ASSISTANT_DENIED: human chat nemá AI výzvu, hlasové ovládanie ani spúšťanie akcií asistenta", () => {
  for (const file of ["app/chat/ChatShell.tsx", "mobile/app/chat/page.tsx", "app/components/chat/ChatConversationList.tsx", "app/components/chat/ChatMessageView.tsx", "app/components/chat/EntityPickerModal.tsx", "lib/chat.ts"]) {
    const src = read(file);
    for (const re of [/VoiceLauncher/, /VoiceSessionControl/, /useVoiceSession/, /IntentResultView/, /executeAction|action\/execute/, /getUserMedia|MediaRecorder/, /confirmationId/]) {
      assert.doesNotMatch(src, re, `${file}: ${re}`);
    }
  }
  // odkazy z chat kariet sú iba detaily entít (nie asistent) a v appke existujú
  const chatLib = read("lib/chat.ts");
  const hrefs = [...chatLib.matchAll(/href:\s*(\w+)\(/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 0);
  for (const helper of hrefs) assert.match(helper, /^(vehicle|machine|inventoryItem)DetailHref$/, helper);
});

await check("AI_ASSISTANT_DENIED: z chatu vedú odkazy iba na obrazovky, kde je vstup asistenta pre zamestnanca skrytý", () => {
  // Entity karty v chate → detail vozidla/stroja/skladu; tie používajú PageShell
  // s VoiceLauncherSlot, ktorý zamestnancovi mimo Inboxu nič nevykreslí.
  for (const view of ["app/vozidla/VehicleDetailView.tsx", "app/stroje/MachineDetailView.tsx", "app/sklad/InventoryItemDetailView.tsx"]) {
    const src = read(view);
    assert.match(src, /DocumentPageShell|PageShell/, view);
    assert.doesNotMatch(src, /<VoiceLauncher\b/, `${view} obchádza VoiceLauncherSlot`);
  }
  // priamy <VoiceLauncher> sa smie vykresliť iba cez VoiceLauncherSlot
  const direct = walk("app", (n) => n.endsWith(".tsx"))
    .filter((f) => f !== "app/components/voice/VoiceLauncherSlot.tsx" && f !== "app/components/voice/VoiceLauncher.tsx")
    .filter((f) => /<VoiceLauncher\b(?!Slot)/.test(read(f)));
  assert.deepEqual(direct, []);
});

// -----------------------------------------------------------------------------
// 5. Shell, asistent, chat
// -----------------------------------------------------------------------------
await check("mobile layout mountuje spodnú navigáciu a obsluhu systémového späť; plávajúci chat v appke nie je", () => {
  const layout = read("mobile/app/layout.tsx");
  assert.match(layout, /<MobileTabBar \/>/);
  assert.match(layout, /<BackButtonBridge \/>/);
  assert.match(layout, /<DeepLinkBridge \/>/);
  const widget = read("app/components/chat/FloatingChatWidget.tsx");
  assert.match(widget, /if \(IS_MOBILE_BUILD\) return null;/);
  // web layout nemá mobilnú lištu
  assert.doesNotMatch(read("app/layout.tsx"), /MobileTabBar/);
});

await check("jediný vstup do asistenta: VoiceLauncherSlot (zamestnanec iba v Inboxe), Dashboard bez druhého menu", () => {
  const slot = read("app/components/voice/VoiceLauncherSlot.tsx");
  assert.match(slot, /if \(!assistantLauncherAllowed\(membership\.role, moduleContext \?\? null\)\) return null;/);
  assert.match(slot, /if \(loading \|\| !membership\) return null;/);
  assert.match(slot, /compact=\{IS_MOBILE_BUILD\}/);
  const dash = read("app/components/Dashboard.tsx");
  assert.match(dash, /\{!IS_MOBILE_BUILD && \(\s*<button[\s\S]*?dashboard\.openMenu/);
});

await check("spodná lišta rezervuje miesto (obsah, sticky akcie, chat) a rešpektuje safe-area", () => {
  const css = read("app/globals.css");
  assert.match(css, /padding-bottom: var\(--mobile-tabbar-space, 0px\);/);
  assert.match(css, /--esblu-safe-bottom: max\(env\(safe-area-inset-bottom, 0px\), var\(--safe-area-inset-bottom, 0px\)\);/);
  const bar = read("app/components/mobile/MobileTabBar.tsx");
  assert.match(bar, /pb-\[var\(--esblu-safe-bottom\)\]/);
  assert.match(bar, /--mobile-tabbar-space", `calc\(\$\{TABBAR_HEIGHT_PX\}px \+ var\(--esblu-safe-bottom\)\)`/);
  for (const file of ["app/faktury/page.tsx", "app/ai-evidencia/page.tsx", "app/priecinky/FolderDetailView.tsx"]) {
    assert.doesNotMatch(read(file), /sticky bottom-4\b/, file);
  }
  assert.match(read("app/chat/ChatShell.tsx"), /h-\[calc\(100dvh-var\(--mobile-tabbar-space,0px\)\)\]/);
});

await check("formuláre na telefóne ≥ 16 px (bez iOS auto-zoom)", () => {
  const css = read("app/globals.css");
  assert.match(css, /@media \(max-width: 639px\) \{\s*input:not\(\[type="checkbox"\]\)[\s\S]*?font-size: 16px;/);
});

// -----------------------------------------------------------------------------
// 6. Dialógy
// -----------------------------------------------------------------------------
await check("žiadne natívne confirm() v app/** (kritické toky používajú confirmAction)", () => {
  const offenders: string[] = [];
  for (const file of walk("app", (n) => n.endsWith(".tsx"))) {
    if (file === "app/components/ui/AppDialog.tsx") continue;
    const src = read(file).replace(/\/\/.*$/gm, "");
    if (/(?<![A-Za-z_.])(window\.)?confirm\(/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

await check("alert() odstránený z faktúr, partnerov, priečinkov, Inboxu a detailu vozidla", () => {
  for (const file of ["app/faktury/InvoiceDetailView.tsx", "app/faktury/page.tsx", "app/obchodni-partneri/page.tsx", "app/obchodni-partneri/PartnerDetailView.tsx", "app/priecinky/FolderDetailView.tsx", "app/ai-evidencia/page.tsx", "app/vozidla/VehicleDetailView.tsx"]) {
    assert.doesNotMatch(read(file).replace(/\/\/.*$/gm, ""), /(?<![A-Za-z_.])(window\.)?alert\(/, file);
  }
});

await check("confirmAction/notify bez hostu padajú späť na natívne okno (akcia sa nikdy nevykoná bez odpovede)", async () => {
  const calls: string[] = [];
  (globalThis as unknown as { window: unknown }).window = {
    confirm: (msg: string) => { calls.push(`confirm:${msg}`); return false; },
    alert: (msg: string) => { calls.push(`alert:${msg}`); },
  };
  const dialog = await import("@/lib/app-dialog");
  assert.match(read("app/components/ui/AppDialog.tsx"), /attachDialogHost\(/);
  assert.equal(await dialog.confirmAction({ message: "Zmazať?", destructive: true }), false);
  await dialog.notify({ message: "Hotovo" });
  assert.deepEqual(calls, ["confirm:Zmazať?", "alert:Hotovo"]);
  delete (globalThis as unknown as { window?: unknown }).window;
});

await check("systémové späť zatvára najvrchnejšiu vrstvu (dialóg/panel) pred odchodom zo stránky", () => {
  const closed: string[] = [];
  const offA = backStack.pushLayer(() => closed.push("more"));
  backStack.pushLayer(() => closed.push("dialog"));
  assert.equal(backStack.openLayerCount(), 2);
  assert.equal(backStack.closeTopLayer(), true);
  assert.deepEqual(closed, ["dialog"]);
  offA();
  assert.equal(backStack.closeTopLayer(), false, "prázdny zásobník → späť patrí histórii");
  const bridge = read("mobile/app/BackButtonBridge.tsx");
  assert.match(bridge, /if \(closeTopLayer\(\)\) return;/);
  assert.match(bridge, /window\.history\.back\(\)/);
});

// -----------------------------------------------------------------------------
// 7. Detail vozidla (kompaktný)
// -----------------------------------------------------------------------------
await check("detail vozidla: kompaktná hlavička, 2 akčné metriky na telefóne, kompaktné upozornenia, posúvateľné záložky", () => {
  const src = read("app/vozidla/VehicleDetailView.tsx");
  assert.match(src, /<BackLink href="\/vozidla"[^>]*className="mb-3 sm:mb-6"/);
  assert.match(src, /<div className="hidden sm:block">\s*<Metric\s+label=\{t\("inbox\.fields\.vykon"\)\}/);
  assert.match(src, /vehicles\.detail\.deadlineOverdue/);
  assert.doesNotMatch(src, /dashboard\.alertOverdue/);
  assert.match(src, /<ScrollTabs[\s\S]*?className="mt-3 sm:mt-6"/);
  // výkon a rok výroby ostávajú v Prehľade (žiadne dáta neodstránené)
  assert.match(src, /\{ label: t\("inbox\.fields\.rokVyroby"\), value: vehicle\.rok_vyroby \}/);
  assert.match(read("app/stroje/MachineDetailView.tsx"), /<ScrollTabs/);
  assert.match(read("app/globals.css"), /\.scroll-tabs \{/);
});

// -----------------------------------------------------------------------------
// 7b. Výkon: obrázky v appke
// -----------------------------------------------------------------------------
await check("obrázky modulov sú WebP (bez 2+ MB PNG pri 56 px ikone); nepoužité rastre sa do appky nekopírujú", () => {
  const dash = read("app/components/Dashboard.tsx");
  assert.doesNotMatch(dash, /\/images\/(van|excavator|warehouse)\.png/);
  for (const name of ["van", "excavator", "warehouse"]) {
    assert.match(dash, new RegExp(`/images/${name}\\.webp`));
    const size = statSync(path.join(ROOT, `public/images/${name}.webp`)).size;
    assert.ok(size < 200 * 1024, `${name}.webp ${size} B`);
  }
  const prep = read("scripts/prepare-mobile-public.mjs");
  for (const file of ["images/van.png", "images/excavator.png", "images/warehouse.png", "images/ai-evidencia.png", "images/background.png", "images/background-dark.png"]) {
    assert.ok(prep.includes(`"${file}"`), file);
  }
});

// -----------------------------------------------------------------------------
// 7c. Overiteľnosť natívneho bundlu na zariadení (real-device regresia)
// -----------------------------------------------------------------------------
await check("natívny bundle je na zariadení rozlíšiteľný od webu (build ID + data-esblu-runtime)", () => {
  const cfg = read("mobile/next.config.ts");
  assert.match(cfg, /NEXT_PUBLIC_ESBLU_MOBILE: "1"/);
  assert.match(cfg, /NEXT_PUBLIC_ESBLU_BUILD_ID: new Date\(\)\.toISOString\(\)/);
  assert.match(read("lib/build-target.ts"), /export const ESBLU_BUILD_ID = process\.env\.NEXT_PUBLIC_ESBLU_BUILD_ID/);
  assert.match(read("mobile/app/layout.tsx"), /<NativeRuntimeMarker \/>/);
  assert.match(read("mobile/app/NativeRuntimeMarker.tsx"), /root\.dataset\.esbluRuntime = IS_MOBILE_BUILD \? "native-app" : "web"/);
  assert.match(read("app/components/mobile/MobileTabBar.tsx"), /t\("nav\.appBuild", \{ build: ESBLU_BUILD_ID \}\)/);
  const verify = read("scripts/verify-mobile-bundle.mjs");
  for (const needle of ['"IS_MOBILE_BUILD",0,!0', "IS_MOBILE_BUILD\\?null:", "--mobile-tabbar-space", "vozidla/detail.html"]) {
    assert.ok(verify.includes(needle), needle);
  }
});

await check("detail vozidla: STK/EK odznaky v hlavičke sa na telefóne neopakujú (stav je v kartách a upozorneniach)", () => {
  const src = read("app/vozidla/VehicleDetailView.tsx");
  assert.match(src, /<span className="hidden sm:inline-flex">\s*<StatusBadge kind="overdue" label=\{t\("vehicles\.fields\.stk"\)\} \/>/);
});

// -----------------------------------------------------------------------------
// 7b. Vodorovné pretečenie stránky (real-device bug 2026-09-28, detail vozidla)
//
// <body> je `flex flex-col`; `mx-auto` na flex položke vypína stretch a šírka
// sa počíta ako fit-content = min-content obsahu. Nowrap pás záložiek mal
// min-content ≈ 2× šírka telefónu → celá stránka 2× široká, STK/EK karty po
// ~100vw, launcher asistenta aj spodná lišta mimo obrazovky.
// -----------------------------------------------------------------------------
await check("PageShell má w-full min-w-0 (žiadny shrink-to-fit v <body flex-col>)", () => {
  assert.match(read("app/layout.tsx"), /<body className="[^"]*\bflex\b[^"]*\bflex-col\b/);
  assert.match(read("app/components/document/DocumentLayout.tsx"), /relative mx-auto w-full min-w-0 \$\{wide/);
  for (const file of ["app/obchodni-partneri/page.tsx", "app/faktury/new/page.tsx"]) {
    assert.match(read(file), /<div className="mx-auto w-full min-w-0 max-w-/, file);
  }
});

await check("ScrollTabs neposúva dokument a nerozťahuje predkov", () => {
  const src = read("app/components/ui/ScrollTabs.tsx");
  const code = src.replace(/\/\/.*$/gm, "");
  assert.ok(!/scrollIntoView\s*\(|\.scrollIntoView\?\./.test(code), "scrollIntoView posúva aj dokument");
  assert.match(code, /el\.scrollLeft =/);
  assert.match(code, /scroll-tabs -mx-1 flex min-w-0 /);
  const css = read("app/globals.css");
  assert.match(css, /\.scroll-tabs \{[^}]*contain: inline-size;/);
  assert.match(css, /html\[data-esblu-runtime="native-app"\],\s*html\[data-esblu-runtime="native-app"\] body \{\s*overflow-x: clip;/);
});

await check("MobileTabBar je fixný na úrovni <body> (mimo PageShell, bez transform predka)", () => {
  const layout = read("mobile/app/layout.tsx");
  assert.match(layout, /\{children\}\s*\{\/\*[^*]*\*\/\}\s*<MobileTabBar \/>\s*<\/RootLayout>/);
  assert.match(read("app/components/mobile/MobileTabBar.tsx"), /className="fixed inset-x-0 bottom-0 z-\[45\]/);
});

// -----------------------------------------------------------------------------
// 7c. Pre-commit autorizačný audit (2026-09-28)
// -----------------------------------------------------------------------------
await check("finančné priame routy: gate hasFinanceView/Manage PRED prvým finančným dotazom", () => {
  const cases: Array<[string, RegExp, RegExp]> = [
    ["app/faktury/page.tsx", /if \(!hasFinanceView\(activeMembership\)\)/, /await loadInvoices\(/],
    ["app/faktury/InvoiceDetailView.tsx", /if \(!activeMembership \|\| !hasFinanceView\(activeMembership\)\)/, /await loadAll\(\)/],
    ["app/faktury/new/page.tsx", /if \(!hasFinanceView\(activeMembership\)\) return;/, /await listBusinessPartners\(/],
    ["app/obchodni-partneri/page.tsx", /if \(!hasFinanceView\(activeMembership\)\)/, /await loadPartners\(/],
    ["app/obchodni-partneri/PartnerDetailView.tsx", /if \(!hasFinanceView\(activeMembership\)\)/, /await getBusinessPartner\(/],
    ["app/priecinky/page.tsx", /if \(active && hasFinanceManage\(active\)\)/, /listDocumentFolders\(supabase\)/],
    ["app/priecinky/FolderDetailView.tsx", /if \(active && hasFinanceManage\(active\)\)/, /await reload\(\)/],
  ];
  for (const [file, gate, fetch] of cases) {
    const src = read(file);
    const g = src.search(gate);
    const f = src.search(fetch);
    assert.ok(g >= 0 && f >= 0 && g <= f, `${file}: gate ${g}, fetch ${f}`);
  }
});

await check("detail vozidla: známky a mazanie servisu iba owner/admin (zrkadlí RLS vehicle_vignettes / vehicle_services_delete)", () => {
  const src = read("app/vozidla/VehicleDetailView.tsx");
  assert.doesNotMatch(src, /canOperate\(role\) &&/, "zápisové ovládače nesmú byť za canOperate (zahŕňa zamestnanca)");
  assert.ok((src.match(/isOwnerOrAdmin\(role\) &&/g) ?? []).length >= 5);
  assert.match(src, /isOwnerOrAdmin\(role\) && \(\s*<button\s+type="button"\s+onClick=\{\(\) => deleteService\(item\.id\)\}/);
});

await check("migrácia 20260930100000: review log iba pre čitateľov dokladu, chat referencia iba na čitateľný doklad", () => {
  const sql = read("supabase/migrations/20260930100000_m1_authz_review_log_and_chat_reference.sql");
  assert.match(sql, /drop policy if exists document_review_log_select_company on public\.document_review_log;/);
  // Log k existujúcemu dokladu = presne právo čítať doklad; finance_view iba pre logy bez dokladu.
  assert.match(sql, /create policy document_review_log_select_readable[\s\S]*?using \(\s*company_id = public\.esblu_my_active_company_id\(\)\s*and \(\s*\(document_id is not null and public\.esblu_can_read_document\(document_id\)\)\s*or \(document_id is null and public\.esblu_my_finance_view\(\)\)/);
  assert.match(sql, /elsif p_entity_type = 'document' then[\s\S]*?and public\.esblu_can_read_document\(p_entity_id\)\s*into v_entity_ok;/);
  assert.match(sql, /revoke execute on function public\.esblu_attach_chat_message_reference\(uuid, text, uuid\) from public, anon;/);
});

await check("migrácia 20260930100000: zápis review logu = iba 'created' k vlastnému čerstvému dokladu; UPDATE/DELETE odobraté", () => {
  const sql = read("supabase/migrations/20260930100000_m1_authz_review_log_and_chat_reference.sql");
  const code = sql.replace(/--.*$/gm, "");
  assert.match(code, /drop policy if exists document_review_log_insert_company on public\.document_review_log;/);
  const policy = code.match(/create policy document_review_log_insert_own_created[\s\S]*?\);\s*\n/)?.[0] ?? "";
  for (const needle of [
    "company_id = public.esblu_my_active_company_id()",
    "user_id = (select auth.uid())",
    "action = 'created'",
    "field_name is null",
    "old_value is null",
    "new_value is null",
    "document_snapshot is null",
    "document_ref = document_id",
    "created_at >= now() - interval '1 minute'",
    "created_at <= now() + interval '1 minute'",
    "public.esblu_can_log_document_created(document_id)",
  ]) {
    assert.ok(policy.includes(needle), needle);
  }
  const fn = code.match(/create or replace function public\.esblu_can_log_document_created[\s\S]*?\$function\$;/)?.[0] ?? "";
  assert.match(fn, /security definer/);
  assert.match(fn, /set search_path to ''/);
  assert.match(fn, /v_user_id is distinct from v_uid/, "iba nahrávajúci");
  assert.match(fn, /v_company_id is distinct from public\.esblu_my_active_company_id\(\)/, "iba vlastná firma");
  assert.match(fn, /v_created_at < now\(\) - interval '15 minutes'/, "iba čerstvý doklad");
  assert.match(fn, /l\.action = 'created'/, "iba raz");
  assert.match(code, /revoke all on function public\.esblu_can_log_document_created\(uuid\) from public, anon;/);
  assert.match(code, /revoke update, delete, truncate on table public\.document_review_log from anon, authenticated;/);
  // Žiadna nová politika nesmie povoliť UPDATE/DELETE auditu.
  assert.doesNotMatch(code, /on public\.document_review_log\s+for (update|delete|all)/);
  // Legitímni pisatelia v appke zapisujú presne tvar, ktorý politika pustí.
  for (const file of ["app/ai-evidencia/page.tsx", "app/vozidla/page.tsx"]) {
    const src = read(file);
    const inserts = [...src.matchAll(/from\("document_review_log"\)\s*\.insert\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
    assert.ok(inserts.length > 0, file);
    for (const body of inserts) {
      assert.match(body, /action: "created"/, file);
      assert.match(body, /user_id: session\.user\.id/, file);
      assert.doesNotMatch(body, /field_name|old_value|new_value|document_snapshot|created_at/, file);
    }
  }
});

await check("migrácia 20260930110000: Inbox zložky zakladá iba owner/admin/accountant", () => {
  const code = read("supabase/migrations/20260930110000_m1_authz_inbox_categories_insert.sql").replace(/--.*$/gm, "");
  assert.match(code, /drop policy if exists custom_document_categories_insert_company on public\.custom_document_categories;/);
  assert.match(code, /create policy custom_document_categories_insert_manager[\s\S]*?for insert\s+to authenticated[\s\S]*?created_by = \(select auth\.uid\(\)\)[\s\S]*?esblu_my_active_role\(\) = any \(array\['owner'::text, 'admin'::text, 'accountant'::text\]\)/);
  assert.doesNotMatch(code, /'employee'/);
  // Brána asistenta má tú istú množinu rolí.
  assert.match(read("lib/intents/permissions.ts"), /case "category_manage":\s*return ctx\.role === "owner" \|\| ctx\.role === "admin" \|\| ctx\.role === "accountant" \? null : "category";/);
});

await check("migrácia 20260930120000: účtovník iba finančné doklady (documents, väzby, prílohy, Storage); iné roly bez zmeny", () => {
  const code = read("supabase/migrations/20260930120000_m1_authz_accountant_document_scope.sql").replace(/--.*$/gm, "");
  // Bez výnimky „vlastný nefinančný upload" (M1 authz final hardening).
  const clause = /\(select public\.esblu_my_active_role\(\)\) is distinct from 'accountant'\s*or public\.esblu_document_requires_finance\(document_type, status\)\s*\)/g;
  assert.equal((code.match(clause) ?? []).length, 4, "select + update using/check + delete");
  for (const fn of ["esblu_can_read_document", "esblu_can_manage_document", "esblu_can_read_ai_inbox_object"]) {
    const body = code.match(new RegExp(`create or replace function public\\.${fn}[\\s\\S]*?\\$function\\$;`))?.[0] ?? "";
    assert.match(body, /security definer/, fn);
    assert.match(body, /v_role = 'accountant'\s*and not public\.esblu_document_requires_finance/, fn);
    assert.match(body, /cm\.status = 'active'/, fn);
  }
  // Pôvodné finančné pravidlá ostali (admin bez financií stále nie).
  assert.match(code, /or public\.esblu_my_finance_view\(\)/);
  assert.match(code, /or public\.esblu_my_finance_manage\(\)\)/);
});

await check("VOICE: guardTranscription — rola a nárok pred audiom/OpenAI", async () => {
  const { guardTranscription } = await import("@/lib/voice/transcribe-guard");
  const calls: string[] = [];
  const deps = (user: { id: string } | null, role: string | null, entitled: boolean) => ({
    getUser: async () => { calls.push("user"); return user; },
    getActiveRole: async () => { calls.push("role"); return role; },
    hasVoiceEntitlement: async () => { calls.push("entitlement"); return entitled; },
  });
  const u = { id: UUID };
  assert.deepEqual(await guardTranscription(deps(null, "owner", true)), { ok: false, status: 401, reason: "UNAUTHENTICATED" });
  // Iná firma / neaktívne členstvo: esblu_my_active_role() vráti null.
  assert.deepEqual(await guardTranscription(deps(u, null, true)), { ok: false, status: 403, reason: "NO_ACTIVE_MEMBERSHIP" });
  calls.length = 0;
  assert.deepEqual(await guardTranscription(deps(u, "employee", true)), { ok: false, status: 403, reason: "ROLE_NOT_ALLOWED" });
  assert.deepEqual(calls, ["user", "role"], "zamestnanec sa ani nedostane k overeniu nároku");
  assert.deepEqual(await guardTranscription(deps(u, "owner", false)), { ok: false, status: 403, reason: "VOICE_ENTITLEMENT_REQUIRED" });
  for (const role of ["owner", "admin", "accountant"]) {
    assert.deepEqual(await guardTranscription(deps(u, role, true)), { ok: true, role }, role);
  }
  // Route: brána beží pred čítaním audia aj pred OpenAI a rola ide z DB, nie z požiadavky.
  const route = read("app/api/assistant/transcribe/route.ts");
  const g = route.indexOf("await guardTranscription(");
  assert.ok(g > 0 && g < route.indexOf("req.formData()") && g < route.indexOf("client.audio.transcriptions.create"));
  assert.match(route, /getActiveRole: \(\) => getActiveRoleForRequest\(req\)/);
  assert.match(read("lib/entitlements-server.ts"), /rpc\("esblu_my_active_role"\)/);
  // UI: mikrofón iba pre rolu s hlasom (server je aj tak autorita).
  assert.match(read("app/components/voice/VoiceSessionControl.tsx"), /!voiceTranscriptionAllowed\(membershipState\.membership\?\.role\)\)\) return null;/);
});

// -----------------------------------------------------------------------------
// 7d. documents INSERT podľa roly a tvaru + podpísané údaje príjmu + SECURITY
//     DEFINER audit (M1 authz final hardening 2026-09-28)
// -----------------------------------------------------------------------------
const MIG = (name: string) => read(`supabase/migrations/${name}.sql`).replace(/--.*$/gm, "");
const M1_AUTHZ_MIGRATIONS = [
  "20260930100000_m1_authz_review_log_and_chat_reference",
  "20260930110000_m1_authz_inbox_categories_insert",
  "20260930120000_m1_authz_accountant_document_scope",
  "20260930125000_m1_authz_intake_extraction_rpc",
  "20260930130000_m1_authz_documents_insert_shape",
  "20260930135000_m1_authz_ai_evidence_insert_shape",
  "20260930140000_m1_authz_intake_storage_immutable",
];

await check("migrácia 20260930130000: documents INSERT — spoločný základ pre každú rolu", () => {
  const code = MIG("20260930130000_m1_authz_documents_insert_shape");
  assert.match(code, /drop policy if exists documents_insert_company on public\.documents;/);
  const policy = code.match(/create policy documents_insert_scoped[\s\S]*?\n  \);/)?.[0] ?? "";
  assert.ok(policy, "politika chýba");
  assert.match(policy, /for insert\s+to authenticated/);
  for (const needle of [
    "company_id = public.esblu_my_active_company_id()",
    "user_id = (select auth.uid())",
    "storage_bucket = 'ai-inbox-documents'",
    "split_part(storage_path, '/', 1) = (select auth.uid())::text",
    "deleted_at is null",
    "archived_from_inbox_at is null",
    "updated_at is null",
    "created_at >= now() - interval '5 minutes'",
    "created_at <= now() + interval '1 minute'",
    "c.company_id = public.esblu_my_active_company_id()",
  ]) {
    assert.ok(policy.includes(needle), needle);
  }
  // Jediná INSERT politika na documents (permissive politiky sa OR-ujú).
  assert.equal((code.match(/on public\.documents\s+for insert/g) ?? []).length, 1);
});

await check("migrácia 20260930130000: vetvy A (finance manage) / B (príjem) / C (owner/admin) — zamestnanec iba B", () => {
  const code = MIG("20260930130000_m1_authz_documents_insert_shape");
  const a = code.match(/-- A\)[\s\S]*?\)\s*\n\s*-- B\)/)?.[0] ?? code.match(/document_type = any \(array\['invoice'::text, 'receipt'::text, 'delivery_note'::text\]\)\s*and public\.esblu_my_finance_manage\(\)/)?.[0] ?? "";
  assert.match(code, /document_type = any \(array\['invoice'::text, 'receipt'::text, 'delivery_note'::text\]\)\s*and public\.esblu_my_finance_manage\(\)/, "A = iba finance manage");
  assert.ok(a.length > 0);
  const b = code.match(/document_type = any \(array\['invoice'::text, 'receipt'::text\]\)\s*and status = 'needs_review'[\s\S]*?custom_category_id is null\s*\)/)?.[0] ?? "";
  for (const needle of ["ai_model is null", "ai_raw_output is null", "extracted_fields is null", "field_confidence is null", "custom_category_id is null"]) {
    assert.ok(b.includes(needle), `B: ${needle}`);
  }
  assert.match(code, /document_type = any \(array\['insurance'::text, 'vehicle_registration'::text, 'service_document'::text, 'other'::text\]\)\s*and \(select public\.esblu_my_active_role\(\)\) = any \(array\['owner'::text, 'admin'::text\]\)/, "C = iba owner/admin");
  assert.doesNotMatch(code, /'employee'|'accountant'/, "žiadna vetva výslovne nepúšťa zamestnanca/účtovníka mimo A/B");
});

await check("príjem: klientský tvar INSERT-u = presne vetva B; podvrhy odmietnuté", async () => {
  const doc = await import("@/lib/intake-document");
  const uid = "11111111-2222-4333-8444-555555555555";
  const other = "99999999-2222-4333-8444-555555555555";
  const row = doc.buildIntakeInsert({
    documentId: UUID, userId: uid, storagePath: `${uid}/${UUID}/scan.webp`, documentType: "receipt",
    originalFilename: "a.jpg", mimeType: "image/webp", fileSize: 10, contentSha256: "b".repeat(64), note: "tankovanie",
  });
  assert.deepEqual(doc.intakeInsertViolations(row, uid), [], "legitímny príjem prejde");
  assert.equal(row.status, "needs_review");
  for (const key of doc.INTAKE_FORBIDDEN_INSERT_COLUMNS) assert.ok(!(key in row), key);
  const forged: Array<[string, Record<string, unknown>]> = [
    ["iný typ (TP)", { ...row, document_type: "vehicle_registration" }],
    ["typ other", { ...row, document_type: "other" }],
    ["stav confirmed", { ...row, status: "confirmed" }],
    ["stav extracted", { ...row, status: "extracted" }],
    ["za iného používateľa", { ...row, user_id: other }],
    ["cudzí súbor", { ...row, storage_path: `${other}/x.webp` }],
    ["iný bucket", { ...row, storage_bucket: "ai-evidence-documents" }],
    ["iná firma", { ...row, company_id: UUID }],
    ["podvrhnuté polia", { ...row, extracted_fields: { supplier: "X", total: 1 } }],
    ["podvrhnutý AI výstup", { ...row, ai_raw_output: { fields: {} } }],
    ["zložka", { ...row, custom_category_id: UUID }],
    ["archivované (mimo Inboxu)", { ...row, archived_from_inbox_at: "2026-01-01T00:00:00Z" }],
    ["spätný dátum", { ...row, created_at: "2020-01-01T00:00:00Z" }],
    ["zmazané", { ...row, deleted_at: "2026-01-01T00:00:00Z" }],
    ["bez hashu originálu", { ...row, content_sha256: null }],
    ["neplatný hash", { ...row, content_sha256: "xyz" }],
  ];
  for (const [label, candidate] of forged) {
    assert.ok(doc.intakeInsertViolations(candidate, uid).length > 0, label);
  }
  // Zrkadlo sedí so SQL: povolené stĺpce ⊆ stĺpce, ktoré vetva B nechá voľné.
  const b = MIG("20260930130000_m1_authz_documents_insert_shape");
  for (const key of ["ai_model", "ai_raw_output", "extracted_fields", "field_confidence", "custom_category_id"]) {
    assert.ok(!(doc.INTAKE_ALLOWED_INSERT_COLUMNS as readonly string[]).includes(key), key);
    assert.match(b, new RegExp(`${key} is null`), key);
  }
});

await check("príjem: route vkladá iba počiatočný tvar pod JWT volajúceho a údaje pripája podpísaným RPC (bez service_role)", () => {
  const route = read("app/api/inbox/intake/route.ts");
  const code = route.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(!/service_role|SERVICE_ROLE|getSupabaseAdmin|supabaseAdmin/i.test(code), "bez service_role");
  // documents
  assert.match(code, /const row = buildIntakeInsert\(\{/);
  assert.match(code, /intakeInsertViolations\(row, user\.id\)\.length > 0\) return fail\(400/);
  assert.match(code, /await db\.from\("documents"\)\.insert\(row\);/);
  assert.doesNotMatch(code.slice(code.indexOf("const row = buildIntakeInsert"), code.indexOf("await db.from(\"documents\").insert(row);")), /extracted_fields|ai_raw_output|field_confidence/);
  // ai_evidence (dodací list)
  assert.match(code, /const evidenceRow = buildEvidenceIntakeInsert\(\{/);
  assert.match(code, /evidenceIntakeInsertViolations\(evidenceRow, user\.id\)\.length > 0\)/);
  assert.match(code, /await db\.from\("ai_evidence"\)\.insert\(evidenceRow\);/);
  assert.doesNotMatch(code, /supplier: text\(|netto: numberOrNull\(|raw_text: text\(/, "route už nevkladá údaje dodacieho listu priamo");
  // podpísané RPC pod JWT volajúceho
  assert.match(code, /await db\.rpc\(rpc, \{/);
  assert.match(code, /p_signature: signIntakeAttestation\(\{ target, rowId, userId: callerId, kind, contentSha256, expiresAt, payloadText, secret \}\)/);
  // Hash originálu = bajty objektu v Storage (stiahnuté pod JWT volajúceho), musí sedieť s pečaťou skenu.
  assert.match(code, /await db\.storage\.from\(bucket\)\.download\(storagePath\)/);
  assert.match(code, /const contentSha256 = sha256HexBytes\(storedBytes\);/);
  assert.match(code, /if \(extraction && extraction\.contentSha256 !== contentSha256\) \{/);
  assert.doesNotMatch(code, /body\.contentSha256/, "hash od klienta sa nepoužíva");
  assert.match(code, /"ai_evidence",\s*"esblu_attach_evidence_intake_extraction",\s*"p_evidence_id",\s*documentId,\s*documentType,\s*buildEvidenceIntakePatch\(extraction\)/);
  // Review uploaderom: potvrdenie až po atestovanom návrhu, cez RPC pod JWT volajúceho.
  assert.match(code, /const confirmNow = body\.confirm === true;/);
  assert.match(code, /confirmed = attached && confirmNow && \(await confirmReviewed\("esblu_confirm_evidence_intake", \{\s*p_evidence_id: documentId,\s*p_values: reviewedEvidence,/);
  assert.match(code, /confirmed = attached && confirmNow && \(await confirmReviewed\("esblu_confirm_intake_document", \{\s*p_document_id: documentId,\s*p_fields: reviewedFields,\s*p_note: note,/);
  assert.match(code, /"documents",\s*"esblu_attach_intake_extraction",\s*"p_document_id",\s*documentId,\s*documentType,\s*buildIntakeExtractionPatch\(documentType, extraction\)/);
  assert.ok(code.indexOf("insert(evidenceRow)") < code.lastIndexOf('"esblu_attach_evidence_intake_extraction",'));
  assert.ok(code.indexOf("insert(row)") < code.lastIndexOf('"esblu_attach_intake_extraction",'));
});

await check("príjem: podpis servera v3 — dĺžkovo prefixovaná správa s hashom originálu, zhodná s SQL, citlivá na každé pole", async () => {
  const att = await import("@/lib/intake-attest");
  const H = "c".repeat(64);
  const base = { target: "documents" as const, rowId: UUID, userId: "11111111-2222-4333-8444-555555555555", kind: "receipt", contentSha256: H, expiresAt: 1790000000, payloadText: '{"extracted_fields":{"supplier":"Čerpačka"}}', secret: "s".repeat(40) };
  const sig = att.signIntakeAttestation(base);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(att.signIntakeAttestation(base), sig, "deterministický");
  for (const [key, value] of [["target", "ai_evidence"], ["rowId", "0f0e0d0c-0b0a-4908-8706-050403020101"], ["userId", "99999999-2222-4333-8444-555555555555"], ["kind", "invoice"], ["contentSha256", "d".repeat(64)], ["expiresAt", 1790000001], ["payloadText", '{"extracted_fields":{"supplier":"Cerpacka"}}'], ["secret", "t".repeat(40)]] as const) {
    assert.notEqual(att.signIntakeAttestation({ ...base, [key]: value }), sig, key);
  }
  assert.equal(
    att.intakeAttestationMessage({ target: "documents", rowId: UUID.toUpperCase(), userId: base.userId, kind: "receipt", contentSha256: H.toUpperCase(), expiresAt: 5, payloadSha256Hex: "AB" }),
    `15:esblu-intake-v3;9:documents;36:${UUID};36:${base.userId};7:receipt;64:${H};1:5;2:ab;`
  );
  const m1 = att.intakeAttestationMessage({ target: "documents", rowId: UUID, userId: base.userId, kind: "a;1:b", contentSha256: H, expiresAt: 5, payloadSha256Hex: "ab" });
  const m2 = att.intakeAttestationMessage({ target: "documents", rowId: UUID, userId: base.userId, kind: "a", contentSha256: H, expiresAt: 5, payloadSha256Hex: "ab" });
  assert.notEqual(m1, m2);
  // UTF-8: "Ž" = bajty C5 BD; bajtový hash originálu = hash tých istých bajtov.
  assert.equal(att.sha256Hex("Ž"), att.sha256HexBytes(new Uint8Array([0xc5, 0xbd])));
  assert.equal(att.INTAKE_ATTEST_TTL_SECONDS <= 600, true);
  const prev = process.env.ESBLU_INTAKE_ATTEST_SECRET;
  process.env.ESBLU_INTAKE_ATTEST_SECRET = "short";
  assert.equal(att.intakeAttestationSecret(), null);
  process.env.ESBLU_INTAKE_ATTEST_SECRET = "k".repeat(32);
  assert.equal(att.intakeAttestationSecret(), "k".repeat(32));
  if (prev === undefined) delete process.env.ESBLU_INTAKE_ATTEST_SECRET; else process.env.ESBLU_INTAKE_ATTEST_SECRET = prev;
  const sql = MIG("20260930125000_m1_authz_intake_extraction_rpc");
  assert.match(sql, /octet_length\('esblu-intake-v3'\)::text \|\| ':' \|\| 'esblu-intake-v3' \|\| ';'\s*\|\| octet_length\(p_target\)::text \|\| ':' \|\| p_target \|\| ';'\s*\|\| octet_length\(p_row_id::text\)::text \|\| ':' \|\| p_row_id::text \|\| ';'\s*\|\| octet_length\(v_uid::text\)::text \|\| ':' \|\| v_uid::text \|\| ';'\s*\|\| octet_length\(p_kind\)::text \|\| ':' \|\| p_kind \|\| ';'\s*\|\| octet_length\(p_content_sha256\)::text \|\| ':' \|\| p_content_sha256 \|\| ';'\s*\|\| octet_length\(p_expires_at::text\)::text \|\| ':' \|\| p_expires_at::text \|\| ';'\s*\|\| '64:' \|\| encode\(extensions\.digest\(convert_to\(p_payload, 'UTF8'\), 'sha256'\), 'hex'\) \|\| ';'/);
  // Hash do správy berie DB z riadku, nie od volajúceho.
  assert.match(sql, /esblu_intake_attestation_consume\('documents', p_document_id, v_type, v_hash, p_payload/);
  assert.match(sql, /esblu_intake_attestation_consume\('ai_evidence', p_evidence_id, v_kind, v_hash, p_payload/);
  assert.match(sql, /where ds\.name in \('esblu_intake_attest_key', 'esblu_intake_attest_key_prev'\)/);
});

await check("RPC: identita z auth.uid(), iba vlastný čerstvý riadok v príjme, jednorazovo (documents aj ai_evidence)", () => {
  const sql = MIG("20260930125000_m1_authz_intake_extraction_rpc");
  const helper = sql.match(/create or replace function public\.esblu_intake_attestation_consume[\s\S]*?\$function\$;/)?.[0] ?? "";
  for (const needle of [
    "v_uid uuid := auth.uid();",
    "if p_target not in ('documents', 'ai_evidence') then",
    "if p_expires_at < v_now or p_expires_at > v_now + 600 then",
    "if v_sig !~ '^[0-9a-f]{64}$' or octet_length(p_payload) > 200000 then",
    "on conflict (signature_sha256) do nothing;",
    "return v_inserted = 1;",
  ]) {
    assert.ok(helper.includes(needle), `helper: ${needle}`);
  }
  assert.match(sql, /revoke all on function public\.esblu_intake_attestation_consume\(text, uuid, text, text, text, bigint, text\) from public, anon, authenticated;/);
  assert.doesNotMatch(sql, /grant execute on function public\.esblu_intake_attestation_consume/);
  assert.match(sql, /revoke all on table public\.esblu_intake_attestations_used from public, anon, authenticated;/);
  const doc = sql.match(/create or replace function public\.esblu_attach_intake_extraction[\s\S]*?\$function\$;/)?.[0] ?? "";
  for (const needle of ["and d.user_id = v_uid", "and d.company_id = public.esblu_my_active_company_id()", "and d.document_type in ('invoice', 'receipt')", "and d.status = 'needs_review'", "and d.extracted_fields is null", "and d.ai_raw_output is null", "and d.created_at >= now() - interval '15 minutes'", "esblu_intake_attestation_consume('documents', p_document_id, v_type,"]) {
    assert.ok(doc.includes(needle), `documents: ${needle}`);
  }
  const ev = sql.match(/create or replace function public\.esblu_attach_evidence_intake_extraction[\s\S]*?\$function\$;/)?.[0] ?? "";
  for (const needle of ["and e.user_id = v_uid", "and e.company_id = public.esblu_my_active_company_id()", "and e.evidence_kind in ('delivery_note', 'weigh_ticket')", "and e.review_status = 'needs_review'", "and e.raw_text is null", "k <> all (v_allowed)", "esblu_intake_attestation_consume('ai_evidence', p_evidence_id, v_kind,"]) {
    assert.ok(ev.includes(needle), `ai_evidence: ${needle}`);
  }
  const evSet = ev.slice(ev.indexOf("update public.ai_evidence"), ev.indexOf("where id = p_evidence_id"));
  assert.ok(evSet.length > 0);
  assert.doesNotMatch(evSet, /\b(vehicle_id|machine_id|machine_label|movement_type|user_id|company_id|evidence_kind|photo_url|deleted_at|created_at)\s*=/, "RPC nemení väzby ani vlastníctvo");
  assert.equal((evSet.match(/\breview_status\s*=/g) ?? []).length, 1);
  assert.match(evSet, /review_status = 'extracted'/, "jediný prechod: needs_review → extracted");
  const docSet = doc.slice(doc.indexOf("update public.documents"), doc.indexOf("where id = p_document_id"));
  assert.doesNotMatch(docSet, /\b(document_type|user_id|company_id|storage_path|custom_category_id|archived_from_inbox_at|deleted_at)\s*=/, "RPC dokladu nemení typ ani vlastníctvo");
  assert.match(docSet, /status = 'extracted'/, "jediný prechod: needs_review → extracted");
  // SQL zoznam povolených kľúčov = TS zoznam
  for (const key of ["spz", "supplier", "customer", "construction_site", "document_number", "material", "quantity", "unit", "brutto", "tara", "netto", "document_date", "document_time", "source_location", "destination_location", "document_language", "confidence_score", "raw_text"]) {
    assert.ok(ev.includes(`'${key}'`), key);
  }
  assert.doesNotMatch(sql, /p_user_id|p_company_id|p_document_type/, "identita, firma ani typ nie sú argumenty");
  assert.doesNotMatch(sql, /return v_key|return v_message|raise [^;]*v_key/);
});

await check("SECURITY DEFINER audit: search_path '', bez anon/public, žiadne argumenty identity vo všetkých M1 authz migráciách", () => {
  let definers = 0;
  for (const name of M1_AUTHZ_MIGRATIONS) {
    const code = MIG(name);
    for (const fn of code.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)[\s\S]*?\$function\$;/g)) {
      const [body, fname, args] = fn;
      if (!/security definer/.test(body)) continue;
      definers++;
      assert.match(body, /set search_path to ''/, `${fname}: search_path`);
      // Výnimka: čistá kontrola existencie cesty pre Storage INSERT politiku
      // (identitu tam overuje samotná politika cez foldername = auth.uid()).
      if (fname !== "esblu_storage_object_is_referenced") assert.match(body, /auth\.uid\(\)/, `${fname}: identita z auth.uid()`);
      assert.doesNotMatch(args, /p_user_id|p_company_id|p_role/, `${fname}: žiadny argument identity/firmy/roly`);
      // Nekvalifikované odkazy na tabuľky by pri search_path '' zlyhali — všetky from/update/insert/join musia mať schému.
      for (const ref of body.matchAll(/(?<!distinct\s)\b(?:from|join|update|insert\s+into)\s+([a-z_][\w.]*)\b(?!\s*\()/gi)) {
        assert.ok(ref[1].includes("."), `${fname}: nekvalifikovaný odkaz „${ref[1]}"`);
      }
      if (fname === "esblu_intake_attestation_consume") {
        // Interný helper: nikto okrem vlastníka (volajú ho iba RPC).
        assert.match(code, new RegExp(`revoke all on function public\\.${fname}\\([^)]*\\) from public, anon, authenticated;`), `${fname}: revoke`);
        assert.doesNotMatch(code, new RegExp(`grant execute on function public\\.${fname}`), `${fname}: bez grantu`);
        continue;
      }
      assert.match(code, new RegExp(`revoke (?:all|execute) on function public\\.${fname}\\([^)]*\\) from public, anon;`), `${fname}: revoke`);
      assert.match(code, new RegExp(`grant execute on function public\\.${fname}\\([^)]*\\) to authenticated;`), `${fname}: grant`);
      assert.doesNotMatch(code, new RegExp(`grant execute on function public\\.${fname}\\([^)]*\\) to (?:anon|public)`), `${fname}: bez anon`);
    }
  }
  // 12 v 100000–135000 + 140000 (storage_object_is_referenced, can_read_ai_inbox_object znova, can_read_ai_evidence_object)
  assert.equal(definers, 15, "všetky SECURITY DEFINER funkcie M1 authz migrácií prešli auditom");
});

await check("účtovník: žiadna výnimka „vlastný nefinančný upload“ (policy ani helpery)", () => {
  const code = MIG("20260930120000_m1_authz_accountant_document_scope");
  assert.doesNotMatch(code.replace(/or \(status = any \(array\['uploaded'::text, 'processing'::text\]\) and user_id = \(select auth\.uid\(\)\)\)/, ""), /or user_id = \(select auth\.uid\(\)\)/);
  assert.doesNotMatch(code, /v_user_id is distinct from v_uid then|v_document_user_id is distinct from v_uid then/);
  assert.equal((code.match(/v_role = 'accountant'\s*and not public\.esblu_document_requires_finance\([^)]*\) then/g) ?? []).length, 3);
});

await check("chat: pripnutie prevádzkovej entity iba s esblu_role_can_operate (účtovník nezistí existenciu vozidla)", () => {
  const code = MIG("20260930100000_m1_authz_review_log_and_chat_reference");
  assert.match(code, /if p_entity_type <> 'document' and not public\.esblu_role_can_operate\(\) then\s*raise exception using errcode = 'P0001', message = 'ESBLU_ENTITY_NOT_FOUND_OR_FORBIDDEN';/);
});

await check("Inbox UI: prevádzkový doklad ukladá iba owner/admin; scan-document pečatí pre všetkých bez finance manage", () => {
  const page = read("app/ai-evidencia/page.tsx");
  assert.match(page, /scanDocumentType !== "invoice" &&\s*scanDocumentType !== "receipt" &&\s*role !== "owner" &&\s*role !== "admin"\s*\) \{\s*setError\(t\("inbox\.errors\.operationalDocumentManagersOnly"\)\);/);
  assert.match(read("app/api/scan-document/route.ts"), /viaIntake = financeManage !== true;/);
});

await check("migrácia 20260930135000: ai_evidence INSERT — základ + vetvy W/D/I; zamestnanec dodací list iba bez údajov", () => {
  const code = MIG("20260930135000_m1_authz_ai_evidence_insert_shape");
  assert.match(code, /drop policy if exists ai_evidence_insert_operational on public\.ai_evidence;/);
  assert.equal((code.match(/on public\.ai_evidence\s+for insert/g) ?? []).length, 1, "jediná INSERT politika");
  for (const needle of [
    "company_id = public.esblu_my_active_company_id()",
    "user_id = (select auth.uid())",
    "public.esblu_role_can_operate()",
    "deleted_at is null",
    "created_at >= now() - interval '5 minutes'",
    "split_part(photo_url, '/', 1) = (select auth.uid())::text",
    "v.company_id = public.esblu_my_active_company_id()",
    "m.company_id = public.esblu_my_active_company_id()",
    "evidence_kind is not null",
    "review_status = any (array['pending'::text, 'needs_review'::text, 'confirmed_candidate'::text, 'confirmed'::text])",
    "(select public.esblu_my_active_role()) = any (array['owner'::text, 'admin'::text])",
    "evidence_kind = 'delivery_note'\n        and public.esblu_my_finance_manage()",
    "evidence_kind = any (array['delivery_note'::text, 'weigh_ticket'::text])",
  ]) {
    assert.ok(code.includes(needle), needle);
  }
  const raw = read("supabase/migrations/20260930135000_m1_authz_ai_evidence_insert_shape.sql");
  const intake = raw.slice(raw.indexOf("-- I) príjem (dodací list alebo vážny lístok)")).replace(/--.*$/gm, "");
  assert.ok(intake.length > 200, "vetva I");
  for (const column of ["vehicle_id", "machine_id", "machine_label", "movement_type", "spz", "supplier", "customer", "construction_site", "document_number", "material", "material_original", "material_category", "quantity", "unit", "brutto", "tara", "netto", "document_date", "document_time", "source_location", "destination_location", "document_language", "confidence_score", "raw_text"]) {
    assert.match(intake, new RegExp(`\\b${column} is null`), `I: ${column}`);
  }
  assert.match(intake, /review_status = 'needs_review'/);
  assert.doesNotMatch(code, /'approved'|'processed'/);
  // 'confirmed' pri vložení iba vo vetvách W (owner/admin) a D (finance.manage), nikdy v príjme.
  assert.doesNotMatch(intake, /'confirmed'/, "príjem nikdy nie confirmed");
});

await check("Inbox saveEvidence spĺňa vetvu W/D (druh, počiatočný stav, vlastný súbor)", () => {
  const page = read("app/ai-evidencia/page.tsx");
  const body = page.slice(page.indexOf("async function saveEvidence()"), page.indexOf("async function saveOtherDocument()"));
  assert.match(body, /evidence_kind: scanDocumentType === "delivery_note" \? "delivery_note" : "weigh_ticket"/);
  assert.match(body, /validatedWeights\.needsReview\s*\? "needs_review"\s*: result\.reviewStatus \|\| "pending"/);
  assert.match(body, /photoPath = `\$\{session\.user\.id\}\//);
  assert.doesNotMatch(body, /company_id:|created_at:|deleted_at:/);
  // scan-document vracia iba needs_review / confirmed_candidate (obe povolené)
  assert.match(read("app/api/scan-document/route.ts"), /const reviewStatus = needsReview \? "needs_review" : "confirmed_candidate";/);
});

await check("tajomstvo podpisu: iba server (bez NEXT_PUBLIC_, nikdy v klientskom kóde ani v migráciách)", () => {
  const attest = read("lib/intake-attest.ts").replace(/^\s*\/\/.*$/gm, "");
  assert.match(attest, /process\.env\.ESBLU_INTAKE_ATTEST_SECRET/);
  assert.doesNotMatch(attest, /NEXT_PUBLIC_/);
  const clientFiles = walk("app", (n) => n.endsWith(".tsx")).concat(walk("hooks", (n) => n.endsWith(".ts")), walk("mobile/app", (n) => /\.tsx?$/.test(n)));
  for (const file of clientFiles) {
    const src = read(file);
    assert.doesNotMatch(src, /intake-attest|ESBLU_INTAKE_ATTEST_SECRET/, file);
  }
  const importers = walk("app", (n) => /\.tsx?$/.test(n)).filter((f) => /intake-attest/.test(read(f)));
  assert.deepEqual(importers, ["app/api/inbox/intake/route.ts"], "iba intake route");
  for (const name of M1_AUTHZ_MIGRATIONS) {
    assert.doesNotMatch(read(`supabase/migrations/${name}.sql`), /decrypted_secret\s*=\s*'|vault\.create_secret\s*\(/, `${name}: žiadne tajomstvo v migrácii`);
  }
});

await check("REVIEW UI: uploader vidí a opraví údaje svojho skenu; uloženie ide cez príjem s potvrdením (nie priamy INSERT)", () => {
  const page = read("app/ai-evidencia/page.tsx");
  // scan: pečať sa uloží, ale review formulár sa naplní (žiadny predčasný return)
  assert.doesNotMatch(page, /if \(scanned\.intakeOnly\) \{[\s\S]{0,400}?return;\s*\}/, "žiadne „iba odoslať“ bez údajov");
  assert.match(page, /if \(scanned\.intakeOnly\) \{[\s\S]{0,600}?intakeDraftRef\.current = persistIntakeDraft\(intakeType, sealed, compressedFile\);/);
  assert.doesNotMatch(page, /t\("assistant\.intake\.explanation"\)/, "starý slepý formulár odstránený");
  // odoslanie nesie skontrolované hodnoty a výslovné potvrdenie
  const submit = page.slice(page.indexOf("async function submitIntakeDocument("), page.indexOf("function resetScanReview()"));
  assert.match(submit, /async function submitIntakeDocument\(reviewed: Record<string, unknown>\)/);
  // potvrdenie ide priamo potvrdzovacím RPC (DB je autorita), nie cez INSERT/UPDATE
  assert.match(submit, /supabase\.rpc\("esblu_confirm_intake_document", \{/);
  assert.match(submit, /supabase\.rpc\("esblu_confirm_evidence_intake", \{/);
  assert.doesNotMatch(submit, /\.from\("(documents|ai_evidence)"\)/);
  const draft = page.slice(page.indexOf("async function persistIntakeDraft("), page.indexOf("async function submitIntakeDocument("));
  assert.match(draft, /"ai-evidence-documents"\s*:\s*"ai-inbox-documents"/);
  assert.match(draft, /upsert: false/, "originál sa nikdy neprepisuje");
  assert.doesNotMatch(draft, /contentSha256/, "hash počíta server z bajtov v Storage, nie klient");
  // vážny lístok / dodací list: intake vetva PRED nahratím fotky a priamym INSERT-om
  const evidence = page.slice(page.indexOf("async function saveEvidence()"), page.indexOf("async function saveOtherDocument()"));
  const branch = evidence.indexOf("if (intakeOnly && (intakeOnly.documentType === \"delivery_note\" || intakeOnly.documentType === \"weigh_ticket\"))");
  assert.ok(branch > 0 && branch < evidence.indexOf('.from("ai-evidence-documents")') && branch < evidence.indexOf('from("ai_evidence").insert('));
  assert.match(evidence.slice(branch, branch + 1500), /vehicle_id: vehicleId,\s*\}\);\s*return;/);
  // faktúra / bloček: intake vetva pred priamym INSERT-om do documents
  const other = page.slice(page.indexOf("async function saveOtherDocument()"), page.indexOf("async function startReceivedInvoiceReview()"));
  const otherBranch = other.indexOf('if (intakeOnly && (scanDocumentType === "invoice" || scanDocumentType === "receipt"))');
  assert.ok(otherBranch > 0 && otherBranch < other.indexOf('from("documents").insert('));
  assert.match(other.slice(otherBranch, otherBranch + 600), /await submitIntakeDocument\(\{ \.\.\.\(otherResult\.fields \?\? \{\}\) \}\);/);
  // prijatá faktúra (spracovanie do Faktúr) ostáva iba finančnému správcovi
  assert.match(page, /\{scanDocumentType === "invoice" && canManageFinance && \(/);
});

await check("REVIEW DB: stavový automat needs_review → extracted → confirmed iba cez RPC; audit po poliach s aktérom auth.uid()", () => {
  const sql = MIG("20260930125000_m1_authz_intake_extraction_rpc");
  const doc = sql.match(/create or replace function public\.esblu_confirm_intake_document[\s\S]*?\$function\$;/)?.[0] ?? "";
  for (const needle of ["and d.user_id = v_uid", "and d.company_id = public.esblu_my_active_company_id()", "and d.document_type in ('invoice', 'receipt')", "and d.status = 'extracted'", "and d.ai_raw_output ->> 'intake' = 'sealed'", "status = 'confirmed'", "'field_edited', v_key, v_old -> v_key, p_fields -> v_key", "'confirmed'"]) {
    assert.ok(doc.includes(needle), `doklad: ${needle}`);
  }
  const ev = sql.match(/create or replace function public\.esblu_confirm_evidence_intake[\s\S]*?\$function\$;/)?.[0] ?? "";
  for (const needle of ["and e.user_id = v_uid", "and e.company_id = v_company", "and e.evidence_kind in ('delivery_note', 'weigh_ticket')", "and e.review_status = 'extracted'", "k <> all (v_allowed)", "v.company_id = v_company", "review_status = 'confirmed'", "'field_edited', v_key"]) {
    assert.ok(ev.includes(needle), `evidencia: ${needle}`);
  }
  // Povolené kľúče review = TS zoznam (bez stavu, vlastníka, firmy, druhu, súboru, raw_text).
  for (const key of ["spz", "supplier", "customer", "construction_site", "document_number", "material", "material_original", "material_category", "unit", "document_time", "source_location", "destination_location", "movement_type", "quantity", "brutto", "tara", "netto", "document_date", "vehicle_id"]) {
    assert.ok(ev.includes(`'${key}'`), key);
  }
  const allowedDecl = ev.slice(ev.indexOf("v_text_keys text[] :="), ev.indexOf("v_allowed text[];"));
  assert.doesNotMatch(allowedDecl, /'review_status'|'user_id'|'company_id'|'evidence_kind'|'photo_url'|'raw_text'|'confidence_score'/);
  // Audit evidencie: iba čítanie pre toho, kto vidí záznam; zápis len RPC.
  assert.match(sql, /revoke all on table public\.ai_evidence_review_log from public, anon, authenticated;\s*grant select on table public\.ai_evidence_review_log to authenticated;/);
  assert.match(sql, /exists \(select 1 from public\.ai_evidence e where e\.id = ai_evidence_review_log\.evidence_id\)/);
  // Žiadne rozšírenie čítania: migrácie nemenia SELECT politiky documents/ai_evidence pre zamestnanca.
  const all = M1_AUTHZ_MIGRATIONS.map((name) => MIG(name)).join("\n");
  assert.doesNotMatch(all, /create policy ai_evidence_select/);
  assert.doesNotMatch(all.replace(/create policy documents_select_company[\s\S]*?\);/, ""), /on public\.documents\s+for select/);
});

await check("DELETE originálu: Storage DELETE iba nenaviazaného objektu; appka maže NAJPRV DB riadok, potom súbor", () => {
  const code = MIG("20260930140000_m1_authz_intake_storage_immutable");
  for (const [policy, bucket, fn] of [["ai_inbox_documents_delete_company", "ai-inbox-documents", "esblu_can_delete_ai_inbox_object"], ["ai_evidence_documents_delete_company", "ai-evidence-documents", "esblu_can_delete_ai_evidence_object"]]) {
    assert.match(code, new RegExp(`create policy ${policy}[\\s\\S]*?for delete[\\s\\S]*?bucket_id = '${bucket}'\\s*and public\\.${fn}\\(name\\)\\s*and not public\\.esblu_storage_object_is_referenced\\(bucket_id, name\\)`), policy);
  }
  const page = read("app/ai-evidencia/page.tsx");
  const att = page.slice(page.indexOf("async function deleteAttachment("), page.indexOf("async function openAttachment("));
  assert.ok(att.indexOf('from("document_attachments")') < att.indexOf(".remove([attachment.storage_path])"), "príloha: najprv riadok");
  const retention = read("lib/document-retention.ts");
  assert.ok(retention.indexOf('.from("documents")\n    .delete()') < retention.indexOf("db.storage.from(bucket).remove(paths)"), "doklad: najprv riadok");
  // Hash backfill iba s výslovným príznakom a nie klientom; atestácia iba s príznakom attach RPC.
  const rpc = MIG("20260930125000_m1_authz_intake_extraction_rpc");
  assert.match(rpc, /v_client boolean := current_user in \('authenticated', 'anon'\);/);
  assert.match(rpc, /current_setting\('esblu\.original_hash_backfill', true\)/);
  assert.match(rpc, /\(v_client or not v_backfill\)/);
  assert.match(rpc, /perform set_config\('esblu\.intake_attestation_write', 'on', true\);/);
  assert.doesNotMatch(rpc, /set_config\('esblu\.original_hash_backfill'/, "žiadna migrácia/RPC si backfill príznak nezapína");
});

// -----------------------------------------------------------------------------
// 8. M0 deep linky nedotknuté
// -----------------------------------------------------------------------------
await check("M0 deep linky ostávajú funkčné", () => {
  const token = "ab".repeat(32);
  assert.equal(resolveEsbluDeepLink(`https://www.esblu.com/invite/${token}`), `/invite.html?token=${token}`);
  assert.equal(resolveEsbluDeepLink("https://www.esblu.com/auth/callback?token_hash=x&type=email"), "/auth/callback.html?token_hash=x&type=email");
  assert.equal(resolveEsbluDeepLink("https://www.esblu.com/faktury"), null, "moduly sa z webového odkazu automaticky neotvárajú");
});

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
